import * as THREE from 'three';
import Matter from 'matter-js';
import Stats from 'stats.js';

// Your existing code...

// Configuration and Constants
const CONFIG = {
    particles: {
        count: 1000,
        size: 0.2,
        color: 0x00ff00,
        physicsSize: 0.1,
        restitution: 0.7,
        friction: 0.1,
        density: 0.001,
        airFriction: 0.01
    },
    physics: {
        gravityScale: 0.001,
        viscosity: 0.01,
        surfaceTension: 0.05,
        iterations: 4,
        substeps: 2
    },
    container: {
        width: 10,
        height: 10,
        depth: 10
    },
    rendering: {
        bloomStrength: 1.5,
        bloomRadius: 0.75,
        bloomThreshold: 0.2,
        exposure: 1.0,
        hdr: true
    },
    debug: {
        showStats: true,
        showInfo: true
    }
};

// Shader Definitions
const Shaders = {
    particle: {
        vertex: `
            attribute float size;
            attribute vec3 color;
            varying vec3 vColor;
            uniform float time;

            void main() {
                vColor = color;
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = size * (300.0 / -mvPosition.z);
                gl_Position = projectionMatrix * mvPosition;

                // Add some movement
                gl_Position.x += sin(time * 2.0 + position.y) * 0.02;
                gl_Position.y += cos(time * 2.0 + position.x) * 0.02;
            }
        `,
        fragment: `
            varying vec3 vColor;
            void main() {
                float r = length(gl_PointCoord - vec2(0.5));
                if (r > 0.5) discard;
                
                float intensity = 1.0 - (r * 2.0);
                intensity = pow(intensity, 1.5);
                
                gl_FragColor = vec4(vColor * intensity, intensity);
            }
        `
    },
    fluid: {
        vertex: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragment: `
            uniform sampler2D tDiffuse;
            uniform float time;
            varying vec2 vUv;
            
            void main() {
                vec2 uv = vUv;
                
                // Distortion
                float distortion = sin(uv.y * 10.0 + time) * 0.01;
                uv.x += distortion;
                
                vec4 color = texture2D(tDiffuse, uv);
                
                // Add some color variation
                color.rgb += vec3(
                    sin(time + uv.x * 10.0) * 0.1,
                    cos(time + uv.y * 10.0) * 0.1,
                    sin(time * 0.5) * 0.1
                );
                
                gl_FragColor = color;
            }
        `
    }
};

// Utility Classes
class KalmanFilter {
    constructor() {
        this.R = 0.01; // measurement noise
        this.Q = 3;    // process noise
        this.A = 1;    // state transition
        this.B = 0;    // control input
        this.C = 1;    // measurement
        this.cov = NaN;
        this.x = NaN;  // estimated value
    }

    filter(measurement) {
        if (isNaN(this.x)) {
            this.x = measurement / this.C;
            this.cov = 1;
        } else {
            // Prediction
            const predX = this.A * this.x + this.B;
            const predCov = this.A * this.A * this.cov + this.Q;

            // Correction
            const K = predCov * this.C / (this.C * predCov * this.C + this.R);
            this.x = predX + K * (measurement - this.C * predX);
            this.cov = predCov - K * this.C * predCov;
        }
        return this.x;
    }
}

// Main Simulation Class
class FluidSimulation {
    constructor() {
        this.clock = new THREE.Clock();
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(
            75, 
            window.innerWidth / window.innerHeight, 
            0.1, 
            1000
        );
        
        this.setupRenderer();
        this.setupScene();
        this.setupPhysics();
        this.setupParticles();
        this.setupPostProcessing();
        this.setupSensors();
        this.setupDebug();
        this.setupEventListeners();
    }

    setupRenderer() {
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            powerPreference: "high-performance",
            alpha: true
        });
        
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = CONFIG.rendering.exposure;
        this.renderer.outputEncoding = THREE.sRGBEncoding;
        
        document.body.appendChild(this.renderer.domElement);
    }
	
	setupScene() {
        // Camera setup
        this.camera.position.z = 15;

        // Lighting
        const ambientLight = new THREE.AmbientLight(0x404040);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
        directionalLight.position.set(1, 1, 1);
        
        const pointLight = new THREE.PointLight(0x0000ff, 1, 20);
        pointLight.position.set(0, 0, 5);
        
        this.scene.add(ambientLight, directionalLight, pointLight);

        // Container visualization
        const containerGeometry = new THREE.BoxGeometry(
            CONFIG.container.width,
            CONFIG.container.height,
            CONFIG.container.depth
        );
        
        const containerMaterial = new THREE.MeshPhysicalMaterial({
            color: 0x156289,
            metalness: 0.9,
            roughness: 0.1,
            transparent: true,
            opacity: 0.2,
            side: THREE.BackSide,
            envMapIntensity: 1,
            clearcoat: 1,
            clearcoatRoughness: 0.1
        });

        this.containerMesh = new THREE.Mesh(containerGeometry, containerMaterial);
        this.scene.add(this.containerMesh);
    }

    setupPhysics() {
        this.engine = Matter.Engine.create({
            constraintIterations: CONFIG.physics.iterations,
            positionIterations: 6,
            velocityIterations: 4
        });

        this.world = this.engine.world;
        this.world.gravity.scale = 0;

        // Create container bounds
        const wallOptions = { 
            isStatic: true,
            restitution: 0.7,
            friction: 0.1
        };

        this.walls = [
            Matter.Bodies.rectangle(0, CONFIG.container.height/2, CONFIG.container.width, 1, wallOptions),
            Matter.Bodies.rectangle(0, -CONFIG.container.height/2, CONFIG.container.width, 1, wallOptions),
            Matter.Bodies.rectangle(-CONFIG.container.width/2, 0, 1, CONFIG.container.height, wallOptions),
            Matter.Bodies.rectangle(CONFIG.container.width/2, 0, 1, CONFIG.container.height, wallOptions)
        ];

        Matter.World.add(this.world, this.walls);
    }

    setupParticles() {
        // Create particle geometry
        const particleGeometry = new THREE.BufferGeometry();
        const positions = new Float32Array(CONFIG.particles.count * 3);
        const colors = new Float32Array(CONFIG.particles.count * 3);
        const sizes = new Float32Array(CONFIG.particles.count);

        this.physicsParticles = [];

        for (let i = 0; i < CONFIG.particles.count; i++) {
            // Initial positions
            const x = (Math.random() - 0.5) * CONFIG.container.width * 0.8;
            const y = (Math.random() - 0.5) * CONFIG.container.height * 0.8;
            const z = (Math.random() - 0.5) * CONFIG.container.depth * 0.8;

            positions[i * 3] = x;
            positions[i * 3 + 1] = y;
            positions[i * 3 + 2] = z;

            // Random colors with a consistent theme
            const hue = Math.random() * 0.1 + 0.5; // Blue-green range
            const color = new THREE.Color().setHSL(hue, 1, 0.5);
            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;

            // Random sizes
            sizes[i] = Math.random() * 0.5 + 0.5;

            // Create physics particle
            const particle = Matter.Bodies.circle(
                x, y,
                CONFIG.particles.physicsSize,
                {
                    restitution: CONFIG.particles.restitution,
                    friction: CONFIG.particles.friction,
                    density: CONFIG.particles.density,
                    frictionAir: CONFIG.particles.airFriction
                }
            );

            this.physicsParticles.push(particle);
            Matter.World.add(this.world, particle);
        }

        particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        particleGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        particleGeometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

        // Create particle material with custom shaders
        const particleMaterial = new THREE.ShaderMaterial({
            uniforms: {
                time: { value: 0 }
            },
            vertexShader: Shaders.particle.vertex,
            fragmentShader: Shaders.particle.fragment,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            vertexColors: true
        });

        this.particles = new THREE.Points(particleGeometry, particleMaterial);
        this.scene.add(this.particles);
    }

    setupPostProcessing() {
        this.composer = new THREE.EffectComposer(this.renderer);

        // Basic render pass
        const renderPass = new THREE.RenderPass(this.scene, this.camera);
        this.composer.addPass(renderPass);

        // Custom fluid pass
        const fluidPass = new THREE.ShaderPass({
            uniforms: {
                tDiffuse: { value: null },
                time: { value: 0 }
            },
            vertexShader: Shaders.fluid.vertex,
            fragmentShader: Shaders.fluid.fragment
        });
        this.composer.addPass(fluidPass);

        // Bloom pass
        const bloomPass = new THREE.UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            CONFIG.rendering.bloomStrength,
            CONFIG.rendering.bloomRadius,
            CONFIG.rendering.bloomThreshold
        );
        this.composer.addPass(bloomPass);
    }

    setupSensors() {
        this.filters = {
            accelerationX: new KalmanFilter(),
            accelerationY: new KalmanFilter(),
            accelerationZ: new KalmanFilter()
        };

        this.sensorData = {
            acceleration: { x: 0, y: 0, z: 0 },
            rotation: { alpha: 0, beta: 0, gamma: 0 }
        };
    }

    setupDebug() {
        if (CONFIG.debug.showStats) {
            this.stats = new Stats();
            document.body.appendChild(this.stats.dom);
        }

        if (CONFIG.debug.showInfo) {
            this.debugInfo = document.getElementById('debug-info');
            if (!this.debugInfo) {
                this.debugInfo = document.createElement('div');
                this.debugInfo.id = 'debug-info';
                document.body.appendChild(this.debugInfo);
            }
        }
    }

    setupEventListeners() {
        window.addEventListener('resize', () => this.onResize());
        window.addEventListener('devicemotion', (e) => this.handleMotion(e));
        window.addEventListener('deviceorientation', (e) => this.handleOrientation(e));
        
        // Touch events
        this.renderer.domElement.addEventListener('touchstart', (e) => this.handleTouch(e));
        this.renderer.domElement.addEventListener('touchmove', (e) => this.handleTouch(e));
    }
	
	handleMotion(event) {
        if (!event.accelerationIncludingGravity) return;

        // Filter and process acceleration data
        this.sensorData.acceleration = {
            x: this.filters.accelerationX.filter(event.accelerationIncludingGravity.x || 0),
            y: this.filters.accelerationY.filter(event.accelerationIncludingGravity.y || 0),
            z: this.filters.accelerationZ.filter(event.accelerationIncludingGravity.z || 0)
        };

        // Scale and apply forces
        const gravity = {
            x: this.sensorData.acceleration.x * CONFIG.physics.gravityScale,
            y: -this.sensorData.acceleration.y * CONFIG.physics.gravityScale
        };

        this.world.gravity = gravity;
    }

    handleOrientation(event) {
        this.sensorData.rotation = {
            alpha: event.alpha || 0,
            beta: event.beta || 0,
            gamma: event.gamma || 0
        };

        // Update container rotation
        if (this.containerMesh) {
            this.containerMesh.rotation.x = THREE.MathUtils.degToRad(this.sensorData.rotation.beta || 0);
            this.containerMesh.rotation.y = THREE.MathUtils.degToRad(this.sensorData.rotation.gamma || 0);
            this.containerMesh.rotation.z = THREE.MathUtils.degToRad(this.sensorData.rotation.alpha || 0);
        }
    }

    handleTouch(event) {
        event.preventDefault();
        
        if (!event.touches[0]) return;

        const touch = event.touches[0];
        const rect = this.renderer.domElement.getBoundingClientRect();
        const x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;

        // Create raycaster for touch interaction
        const raycaster = new THREE.Raycaster();
        const touchPosition = new THREE.Vector2(x, y);
        raycaster.setFromCamera(touchPosition, this.camera);

        // Apply force to particles near touch point
        const touchForce = 0.005;
        const touchRadius = 2;

        this.physicsParticles.forEach(particle => {
            const particlePosition = new THREE.Vector3(
                particle.position.x,
                particle.position.y,
                0
            );

            const distance = raycaster.ray.distanceToPoint(particlePosition);

            if (distance < touchRadius) {
                const force = (1 - distance / touchRadius) * touchForce;
                const forceVector = raycaster.ray.direction.multiplyScalar(force);

                Matter.Body.applyForce(particle, particle.position, {
                    x: forceVector.x,
                    y: forceVector.y
                });
            }
        });
    }

    updateParticles() {
        const positions = this.particles.geometry.attributes.position.array;
        const colors = this.particles.geometry.attributes.color.array;
        const sizes = this.particles.geometry.attributes.size.array;

        this.physicsParticles.forEach((particle, i) => {
            // Update positions
            positions[i * 3] = particle.position.x;
            positions[i * 3 + 1] = particle.position.y;
            positions[i * 3 + 2] = 0;

            // Update colors based on velocity
            const speed = Math.sqrt(
                particle.velocity.x * particle.velocity.x +
                particle.velocity.y * particle.velocity.y
            );
            
            const hue = (speed * 2) % 1;
            const color = new THREE.Color().setHSL(hue, 1, 0.5);
            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;

            // Update sizes based on z-position
            sizes[i] = Math.max(0.5, 1 - Math.abs(positions[i * 3 + 2]) * 0.1);
        });

        this.particles.geometry.attributes.position.needsUpdate = true;
        this.particles.geometry.attributes.color.needsUpdate = true;
        this.particles.geometry.attributes.size.needsUpdate = true;
    }

    updatePhysics(deltaTime) {
        // Apply viscosity
        this.physicsParticles.forEach(particle => {
            Matter.Body.setVelocity(particle, {
                x: particle.velocity.x * (1 - CONFIG.physics.viscosity),
                y: particle.velocity.y * (1 - CONFIG.physics.viscosity)
            });
        });

        // Apply surface tension
        for (let i = 0; i < this.physicsParticles.length; i++) {
            const particleA = this.physicsParticles[i];
            
            for (let j = i + 1; j < this.physicsParticles.length; j++) {
                const particleB = this.physicsParticles[j];
                
                const dx = particleB.position.x - particleA.position.x;
                const dy = particleB.position.y - particleA.position.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < 2 && distance > 0) {
                    const force = CONFIG.physics.surfaceTension * (1 - distance / 2);
                    const fx = (dx / distance) * force;
                    const fy = (dy / distance) * force;

                    Matter.Body.applyForce(particleA, particleA.position, { x: fx, y: fy });
                    Matter.Body.applyForce(particleB, particleB.position, { x: -fx, y: -fy });
                }
            }
        }

        // Update physics engine
        Matter.Engine.update(this.engine, deltaTime * 1000);
    }

    updateDebugInfo() {
        if (this.debugInfo) {
            this.debugInfo.textContent = `
                FPS: ${Math.round(1000 / this.stats.delta)}
                Particles: ${CONFIG.particles.count}
                Acceleration: 
                    x: ${this.sensorData.acceleration.x.toFixed(3)}
                    y: ${this.sensorData.acceleration.y.toFixed(3)}
                    z: ${this.sensorData.acceleration.z.toFixed(3)}
                Rotation: 
                    α: ${this.sensorData.rotation.alpha.toFixed(1)}°
                    β: ${this.sensorData.rotation.beta.toFixed(1)}°
                    γ: ${this.sensorData.rotation.gamma.toFixed(1)}°
            `;
        }
    }

    onResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);
        this.composer.setSize(width, height);
    }

    update() {
        if (!this.isRunning) return;

        if (this.stats) this.stats.begin();

        const deltaTime = this.clock.getDelta();
        const elapsedTime = this.clock.elapsedTime;

        // Update physics
        this.updatePhysics(deltaTime);

        // Update particles
        this.updateParticles();

        // Update shader uniforms
        this.particles.material.uniforms.time.value = elapsedTime;
        this.composer.passes.forEach(pass => {
            if (pass.uniforms && pass.uniforms.time) {
                pass.uniforms.time.value = elapsedTime;
            }
        });

        // Render
        this.composer.render();

        // Update debug info
        if (this.frameCount % 10 === 0) {
            this.updateDebugInfo();
        }

        this.frameCount++;

        if (this.stats) this.stats.end();

        requestAnimationFrame(() => this.update());
    }

    start() {
        this.isRunning = true;
        this.frameCount = 0;
        this.update();
    }

    pause() {
        this.isRunning = false;
    }

    resume() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.update();
        }
    }

    dispose() {
        // Clean up resources
        this.isRunning = false;
        
        // Dispose of Three.js resources
        this.scene.traverse(object => {
            if (object.geometry) object.geometry.dispose();
            if (object.material) {
                if (object.material.map) object.material.map.dispose();
                object.material.dispose();
            }
        });

        this.composer.dispose();
        this.renderer.dispose();

        // Remove event listeners
        window.removeEventListener('resize', this.onResize);
        window.removeEventListener('devicemotion', this.handleMotion);
        window.removeEventListener('deviceorientation', this.handleOrientation);
        
        // Clean up physics engine
        Matter.World.clear(this.world);
        Matter.Engine.clear(this.engine);

        // Remove stats if exists
        if (this.stats && this.stats.dom.parentElement) {
            this.stats.dom.parentElement.removeChild(this.stats.dom);
        }
    }
}

// Initialize application
document.addEventListener('DOMContentLoaded', async () => {
    const startButton = document.getElementById('start-button');
    
    startButton.addEventListener('click', async () => {
        // Request device motion/orientation permissions (iOS)
        if (typeof DeviceOrientationEvent !== 'undefined' && 
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
                const permission = await DeviceOrientationEvent.requestPermission();
                if (permission !== 'granted') {
                    alert('Permission to access device sensors was denied');
                    return;
                }
            } catch (error) {
                console.error('Error requesting device permission:', error);
                return;
            }
        }

        // Hide loading screen
        document.getElementById('loading-screen').style.display = 'none';

        // Create and start simulation
        const simulation = new FluidSimulation();
        simulation.start();
    });
});